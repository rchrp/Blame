export type CloudAuthRequestInput = {
  body?: string
  headers: Record<string, string>
  method: string
  url: string
}

export type CloudAuthRequestResponse = {
  body: string
  headers: Record<string, string>
  status: number
}

export type CloudAuthRequestClient = {
  request(input: CloudAuthRequestInput): Promise<CloudAuthRequestResponse>
}
