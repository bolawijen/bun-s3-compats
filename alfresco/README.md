# Bun S3 Alfresco

Use [Bun's S3 APIs](https://bun.sh/docs/api/s3) for interacting with Alfresco files

## Installation
```sh
bunx jsr add @bun-s3-compats/alfresco
```

## Usage
```diff
- import { S3Client } from "bun";
+ import { AlfrescoClient as S3Client } from "@bun-s3-compats/alfresco";
```
```ts
const client = new S3Client({
  accessKeyId: "user ID",
  secretAccessKey: "password",
  bucket: "my-bucket",
  endpoint: "http://localhost:9000", 
});

const s3file: S3File = client.file("123.json");

const text = await s3file.text(); // Read an S3File as text

const json = await s3file.json(); // Read an S3File as JSON

const buffer = await s3file.arrayBuffer(); // Read an S3File as an ArrayBuffer

// Stream the file
const stream = s3file.stream();
for await (const chunk of stream) {
  console.log(chunk);
}

await s3file.write("Hello World!"); // Write a string (replacing the file)

const downloadUrl = await s3file.presign({inline: true}) // Generate a presigned URL
```
