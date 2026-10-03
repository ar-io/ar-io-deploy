/**
 * Shared upload client/result types used by the Turbo upload path.
 *
 * These describe the minimal surface the uploader and workflow rely on,
 * independent of any specific bundler implementation.
 */

export interface UploadFileArgs {
  dataItemOpts?: { paidBy?: string[]; tags?: Array<{ name: string; value: string }> }
  file?: string | Buffer
  fileSizeFactory?: () => number
  fileStreamFactory?: () => unknown
}

export interface UploadClient {
  /**
   * The signer behind the client, when there is one.
   *
   * Incremental uploads need the uploader's own public key: a `File-SHA256`
   * tag is a claim anyone can make, so only the wallet's own past
   * transactions are trusted to answer "have I already paid for these bytes?".
   * The key, not `getNativeAddress()` — see `ownerAddressFromPublicKey`.
   */
  signer?: { getPublicKey: () => Promise<Buffer | Uint8Array> }
  uploadFile: (args: UploadFileArgs) => Promise<UploadClientResult>
}

export interface UploadClientResult {
  id?: string
}
