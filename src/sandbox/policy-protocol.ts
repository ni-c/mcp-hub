/**
 * Wire contract between the internet-facing hub and the Docker policy proxy.
 *
 * Bump this whenever either side changes the meaning of an allowed Docker
 * request. A release version is deliberately not used: patch releases that do
 * not change the policy remain interoperable, while policy drift fails closed.
 */
export const DOCKER_POLICY_VERSION = 1;
export const DOCKER_POLICY_PATH = '/_mcp_hub/policy';
export const DOCKER_POLICY_NAME = 'mcp-hub-docker-proxy';

export interface DockerPolicyHandshake {
  name: typeof DOCKER_POLICY_NAME;
  policyVersion: number;
  daemon: 'ok';
}
