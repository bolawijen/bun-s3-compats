import { BunFile, NetworkSink, S3Client, S3File, S3FilePresignOptions, S3Options, S3Stats } from 'bun';
import path from 'path/posix';



type AlfrescoOptions = S3Options
type AlfrescoFilePresignOptions = S3FilePresignOptions & { inline: boolean }


function createTicket(opts) {
    return fetch(buildUrl('/authentication/versions/1/tickets', opts), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            userId: opts.accessKeyId,
            password: opts.secretAccessKey
        }),
    })
    .then(res => res.json())
    .then(data => btoa(data.entry.id))
}

function getTicket(ticket, opts) {
    return ticket.id || createTicket(opts).then(id => ticket.id = id)
}

async function request(url, ticket, opts, method?, body?, headers = {}) {
    return fetch(buildUrl(`/alfresco/versions/1${url}`, opts), { body, method, headers: { 'Authorization': `Basic ${await getTicket(ticket, opts)}`, ...headers } })
}

function buildUrl(path: string, opts: AlfrescoOptions) {
    return `${opts.endpoint}/alfresco/api/-default-/public${path}`;
}

function buildPath(file_path: string, opts: AlfrescoOptions, dirname = false) {
    return path.join(opts.bucket!, dirname ? path.dirname(file_path) : file_path)
}

export class AlfrescoClient extends S3Client {
    #opts: AlfrescoOptions
    #ticket = {}

    #cloneOptions = (...args) => {
        const opts = Object.assign({}, this.#opts, {ticket: this.#ticket})
        for (const arg of args) {
            Object.assign(opts, arg)
        }
        return opts
    }

    constructor(opts: AlfrescoOptions) {
        super(opts)
        this.#opts = opts
    }

    file(path: string, options?: AlfrescoOptions): AlfrescoFile {
        return new AlfrescoFile(path, this.#ticket, this.#cloneOptions(options), this)
    }

    stat(path: string, options?: S3Options): Promise<S3Stats> {
        options = this.#cloneOptions(options)
        return request(`/nodes/-my-?relativePath=${buildPath(path, options)}`, options.ticket, options)
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    return Promise.reject(data.error.briefSummary)
                }
    
                data = data.entry
                data.type = data.nodeType
                data.size = data.content.length
                data.lastModified = new Date(data.content.modifiedAt)

                delete data.content.sizeInBytes
                delete data.content.mimeType
                delete data.modifiedAt

                return data
            })
    }

    exists = (path: string, options?: S3Options) => this.stat(path, options).then(stat => Boolean(stat.type)).catch(() => false)
    size = (path: string, options?: S3Options) => this.stat(path, options).then(stat => stat.size)

    presign(file_path: string, options?: AlfrescoFilePresignOptions) {
        options = this.#cloneOptions(options) as never as AlfrescoFilePresignOptions
        return this.stat(file_path, options)
            .then(stat => {
                const headers = { 'content-type': 'application/json' }
                const body = JSON.stringify({ nodeId: stat.id, expiresAt: options.expiresAt })
                return request('/shared-links', options.ticket, options, 'POST', body, headers)
            })
            .then(res => res.json())
            .then(data => {
                if (data.error?.statusCode === 409)
                    data.entry = {id: data.error.errorKey.match(/\[(.+)\]/)[1]}

                return `${options?.endpoint}/share/proxy/alfresco-noauth/api/internal/shared/node/${data.entry.id}/content/${path.basename(file_path)}?c=force&noCache=${Date.now()}&a=${Boolean(options.inline)}`;
            })
    }

    write(file_path, data, options?: AlfrescoOptions) {
        options = this.#cloneOptions(options) as never as AlfrescoOptions
        const req_body = new FormData()
        req_body.append('filedata', new Blob([data]), path.basename(file_path))
        req_body.append('nodeType', 'cm:content')
        req_body.append('name', path.basename(file_path))
        req_body.append('relativePath', buildPath(file_path, options, true))
        return request(`/nodes/-my-/children`, this.#ticket, options, 'POST', req_body)
            .then(res => res.json())
            .then(data => data?.entry?.content?.sizeInBytes as number)
    }

    cp(src, dest, options) {}
    rename(src, dest, options) {}

    delete = (path: string, options?: S3Options) => request(`/nodes/${path}`, this.#ticket, this.#cloneOptions(options), 'DELETE').then(() => {})

    mkdir(path, options) {}

    readdir(path, options) {}
}

class AlfrescoFile extends Blob implements S3File {
    #id: string
    #path: string
    #client: AlfrescoClient
    #stat: S3Stats
    #options
    #ticket

    constructor(path, ticket, options, client) {
        super()
        this.#ticket = ticket
        this.#options = options
        this.#client = client
        this.#path = path

        for (const prop of ['stat','exists','presign','slice','arrayBuffer','bytes','formData','text','json','unlink','delete']) {
            Object.defineProperty(this, prop, { enumerable: false, value: this[prop] })
        }
    }

    get readable(): ReadableStream {
        const file = this
        let reader: ReadableStreamDefaultReader
        return new ReadableStream({
            type: 'bytes',
            start() {
                return Promise.resolve() // @ts-ignore
                    .then(() => file.name || file.stat())
                    .then(() => request(`/nodes/${file.#id}/content`, file.#ticket, file.#options))
                    .then(res => reader = res.body?.getReader()!)
            },
            pull(ctrl) {
                reader.read().then(chunk => {
                    chunk.done ? ctrl.close() : ctrl.enqueue(chunk.value)
                })
            },
        })
    }

    async stat() {
        return this.#stat
            || this.#client
                .stat(this.#path, this.#options)
                .then((stat: any) => {
                    this.#id = stat.id
                    return this.#stat = stat as S3Stats
                })
    }

    stream = () => this.readable
    exists = () => this.stat().then(Boolean)
    presign = (options?: AlfrescoFilePresignOptions) => this.#client.presign(this.#path, {...this.#options, ticket: this.#ticket, ...options})
    blob = () => Bun.readableStreamToBlob(this.stream())
    text = () => Bun.readableStreamToText(this.stream())
    json = () => Bun.readableStreamToJSON(this.stream())
    bytes = () => Bun.readableStreamToBytes(this.stream()) as Promise<Uint8Array>
    formData = () => Bun.readableStreamToFormData(this.stream()) as Promise<FormData>
    arrayBuffer = () => Bun.readableStreamToArrayBuffer(this.stream()) as Promise<ArrayBuffer>
    slice(start?: number, end?: number, contentType?: string): AlfrescoFile {
        this.#options.sliceStart = start
        this.#options.sliceEnd = end
        this.#options.sliceContentType = contentType
        return new AlfrescoFile(this, this.#ticket, this.#options, this.#client)
    }
    write(data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer | Request | Response | BunFile | S3File | Blob, options?: S3Options): Promise<number> {
    }
    writer(options?: S3Options): NetworkSink {
    }
    delete = () => this.#client.delete(this.name, this.#options)
    unlink = this['delete']
}