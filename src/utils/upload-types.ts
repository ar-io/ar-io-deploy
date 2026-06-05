/**
 * Shared upload client/result types used by the Turbo upload path.
 *
 * These describe the minimal surface the uploader and workflow rely on,
 * independent of any specific bundler implementation.
 */

export interface UploadFileArgs {
  dataItemOpts?: { tags?: Array<{ name: string; value: string }> }
  file?: string | Buffer
  fileSizeFactory?: () => number
  fileStreamFactory?: () => unknown
  fundingMode?: unknown
}

export interface UploadClient {
  uploadFile: (args: UploadFileArgs) => Promise<UploadClientResult>
}

export interface UploadClientResult {
  cost?: UploadCost
  id?: string
  size?: UploadSize
}

export interface UploadCost {
  amount: bigint
  token: string
}

export interface UploadSize {
  payloadBytes: number
  signedBytes?: number
}
