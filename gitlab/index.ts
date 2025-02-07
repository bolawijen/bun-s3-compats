import { BunFile, NetworkSink, S3Client, S3File, S3FilePresignOptions, S3Options, S3Stats } from 'bun';
import path from 'path/posix';


type GitlabOptions = S3Options & { project_id: string; branch: string }
type GitlabFilePresignOptions = S3FilePresignOptions & GitlabOptions & { inline: false }
type WritaData = string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer | Request | Response | BunFile | S3File | Blob


const API_VERSION = 'v4';


function buildURI(uri, opts) {
    return path.join(opts.endpoint, 'api', API_VERSION, 'projects', opts.project_id, 'repository/files', uri) + `?ref=${opts.branch}`;
}

async function request(uri, opts, method?, body?, headers = {}) {
    return fetch(buildURI(uri, opts), { body, method, headers: { 'PRIVATE-TOKEN': opts.secretAccessKey, ...headers } })
}

export class GitlabClient extends S3Client {
    #opts: GitlabOptions

    #cloneOptions = (...args) => {
        const opts = Object.assign({}, this.#opts)
        for (const arg of args) {
            Object.assign(opts, arg)
        }
        return opts
    }

    constructor(opts: GitlabOptions) {
        super(opts)
        this.#opts = opts
    }

    file(path: string, options?: GitlabOptions): GitlabFile {
        return new GitlabFile(path, this.#cloneOptions(options), this)
    }

    stat(path: string, options?: S3Options): Promise<S3Stats> {
        return request(encodeURIComponent(path), this.#cloneOptions(options), 'HEAD')
            .then(res => {
                const data = {}
                for (const [name, value] of res.headers) {
                    if (name.startsWith('x-gitlab')) {
                        data[name.slice(9)] = value
                    }
                }

                data.size = Number(data.size)

                return data
            })
    }

    exists = (path: string, options?: S3Options) => this.stat(path, options).then(stat => Boolean(stat.type)).catch(() => false)
    size = (path: string, options?: S3Options) => this.stat(path, options).then(stat => stat.size)

    presign(file_path: string, options?: GitlabFilePresignOptions) {
        options = this.#cloneOptions(options) as GitlabFilePresignOptions
        return path.join(options?.endpoint!, options?.bucket!, '-/raw', options.branch!, file_path) + '?inline=' + Boolean(options.inline)
    }

    write(file_path, data: WritaData, options?: GitlabOptions) {
        const req_body = new FormData()
        options = this.#cloneOptions(options)
        req_body.append('content', data as string)
        req_body.append('commit_message', 'Uploaded a file')
        req_body.append('branch', options?.branch!)
        return request(encodeURIComponent(file_path), options, 'POST', req_body)
            .then(res => {
                if (res.status === 201) {
                    // @ts-ignore
                    return data.size || data.length
                }
            })
    }

    cp(src, dest, options) {}
    rename(src, dest, options) {}

    delete = (path: string, options?: S3Options) => request(`/nodes/${NODE_ID}`, this.#cloneOptions(options), 'DELETE').then(() => {})

    mkdir(path, options) {}

    readdir(path, options) {}
}


class GitlabFile extends Blob implements S3File {
    path: string
    name: string
    #client: GitlabClient
    #stat: S3Stats
    #options

    constructor(path, options, client) {
        super()
        this.path = path
        this.#options = options
        this.#client = client

        for (const prop of ['stat','exists','presign','slice','arrayBuffer','bytes','formData','text','json','unlink','delete']) {
            Object.defineProperty(this, prop, { enumerable: false, value: this[prop] })
        }
    }

    get readable() {
        let s3file = this
        let reader: ReadableStreamDefaultReader
        return new ReadableStream({
            type: 'bytes',
            start() {
                return Promise.resolve()
                    .then(() => request(`${encodeURIComponent(s3file.path)}/raw`, s3file.#options))
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
                .stat(this.path, this.#options)
                .then((stat: any) => {
                    this.name = stat.name
                    return this.#stat = stat as S3Stats
                })
    }

    stream = () => this.readable
    exists = () => this.stat().then(s => Boolean(s?.type))
    presign = (options?: GitlabFilePresignOptions) => this.#client.presign(this.path, {...this.#options, ...options})
    blob = () => Bun.readableStreamToBlob(this.readable)
    text = () => Bun.readableStreamToText(this.readable)
    json = () => Bun.readableStreamToJSON(this.readable)
    bytes = () => Bun.readableStreamToBytes(this.readable) as Promise<Uint8Array>
    formData = () => Bun.readableStreamToFormData(this.readable) as Promise<FormData>
    arrayBuffer = () => Bun.readableStreamToArrayBuffer(this.readable) as Promise<ArrayBuffer>
    slice(start?: number, end?: number, contentType?: string): GitlabFile {
        this.#options.sliceStart = start
        this.#options.sliceEnd = end
        this.#options.sliceContentType = contentType
        return new GitlabFile(this, this.#options, this.#client)
    }
    write = (data: WritaData, options?: GitlabOptions) => this.#client.write(this.path, data, options)
    writer(options?: S3Options): NetworkSink {
    }
    delete = () => this.#client.delete(this.name, this.#options)
    unlink = this['delete']
}