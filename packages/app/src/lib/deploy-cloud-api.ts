import type {
  DeployConnection,
  DeploymentManifest,
  DeployProject,
  DeployTarget,
  ProjectDeployment,
} from "@blame/deploy-contract"

export type CloudRequester = <T>(path: string, init?: RequestInit) => Promise<T>

export function createDeployCloudApi(request: CloudRequester) {
  return {
    vercelConnectIntent() {
      return request<{ url: string; expiresAt: string }>(
        "/integrations/vercel/connect-intents",
        { method: "POST" }
      )
    },
    vercelConnections() {
      return request<{ connections: DeployConnection[] }>(
        "/integrations/vercel/connections"
      )
    },
    vercelProjects(connectionId: string, cursor?: string) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
      return request<{
        projects: DeployProject[]
        nextCursor: string | null
      }>(
        `/integrations/vercel/connections/${encodeURIComponent(connectionId)}/projects${query}`
      )
    },
    unlinkVercel(connectionId: string) {
      return request<void>(
        `/integrations/vercel/connections/${encodeURIComponent(connectionId)}/link`,
        { method: "DELETE" }
      )
    },
    deployTarget(projectId: string) {
      return request<{ target: DeployTarget | null }>(
        `/projects/${encodeURIComponent(projectId)}/deploy-target`
      )
    },
    saveDeployTarget(
      projectId: string,
      input: {
        connectionId: string
        providerProjectId: string | null
        providerProjectName: string
        manifest: DeploymentManifest
      }
    ) {
      return request<{ target: DeployTarget }>(
        `/projects/${encodeURIComponent(projectId)}/deploy-target`,
        { body: JSON.stringify(input), method: "PUT" }
      )
    },
    deployments(projectId: string) {
      return request<{ deployments: ProjectDeployment[] }>(
        `/projects/${encodeURIComponent(projectId)}/deployments`
      )
    },
    deployment(projectId: string, deploymentId: string) {
      return request<{ deployment: ProjectDeployment }>(
        `/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}`
      )
    },
    cancelDeployment(projectId: string, deploymentId: string) {
      return request<{ deployment: ProjectDeployment }>(
        `/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/cancel`,
        { method: "POST" }
      )
    },
    deploymentLogs(projectId: string, deploymentId: string) {
      return request<{ logs: Array<{ created: number; message: string }> }>(
        `/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/logs`
      )
    },
  }
}
