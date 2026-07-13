export const PUBLIC_API_ROUTES = ["/api/health", "/api/ready"] as const;

const publicApiRouteSet: ReadonlySet<string> = new Set(PUBLIC_API_ROUTES);

export function isPublicApiPath(pathname: string) {
  return publicApiRouteSet.has(pathname);
}
