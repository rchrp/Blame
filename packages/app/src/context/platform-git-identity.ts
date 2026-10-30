export type GitIdentity = {
  // False when Git cannot run here: the host checks report that.
  available: boolean
  configured: boolean
  email: string
  name: string
}

// The name and email Git signs commits with, from this machine's settings.
export type GitIdentityClient = {
  read(input?: { root?: string }): Promise<GitIdentity>
  save(input: { email: string; name: string }): Promise<{
    email: string
    name: string
  }>
}
