import type { FastifyInstance, FastifyRequest } from "fastify";

export type OperatorConfig = { publishableKey: string; secretKey: string; allowedEmails: Set<string>; allowedOrg: string };
type Session = { userId: string; orgId: string | null };
type Email = { emailAddress: string; verified: boolean };
export type InstallOperatorAuth = (app: FastifyInstance, config: OperatorConfig) => Promise<{
  session: (request: FastifyRequest) => Session | null;
  primaryEmail: (request: FastifyRequest, userId: string) => Promise<Email | null>;
}>;

export function operatorConfig(env: NodeJS.ProcessEnv): OperatorConfig | null {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY?.trim();
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!publishableKey || !secretKey) return null;
  return {
    publishableKey, secretKey,
    allowedEmails: new Set(env.CLERK_ALLOWED_EMAILS?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    allowedOrg: env.CLERK_ALLOWED_ORG?.trim() ?? "",
  };
}

const installClerk: InstallOperatorAuth = async (app, config) => {
  const { clerkPlugin, getAuth } = await import("@clerk/fastify");
  await app.register(clerkPlugin, {
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    __internal_enableHandshake: false,
  });
  return {
    session(request) {
      const auth = getAuth(request);
      return auth.userId && auth.sessionId ? { userId: auth.userId, orgId: auth.orgId ?? null } : null;
    },
    async primaryEmail(request, userId) {
      const user = await request.clerk.users.getUser(userId);
      const primary = user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId);
      return primary ? { emailAddress: primary.emailAddress, verified: primary.verification?.status === "verified" } : null;
    },
  };
};

export async function protectInternalRoutes(app: FastifyInstance, config: OperatorConfig, install = installClerk) {
  // Handle a missing credential locally, before Clerk can attempt a browser handshake.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    if (!request.headers.authorization && !/(?:^|;\s*)__session(?:_[\w-]+)?=/.test(request.headers.cookie ?? "")) {
      return reply.code(401).send({ error: "sign in required" });
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    // Clerk's development handshake can return a redirect even with handshakes disabled.
    // These are JSON API routes, never navigation targets.
    if (reply.statusCode >= 300 && reply.statusCode < 400 && reply.getHeader("location")) {
      reply.removeHeader("location").code(401).type("application/json");
      return JSON.stringify({ error: "sign in required" });
    }
    return payload;
  });
  const auth = await install(app, config);
  app.addHook("preHandler", async (request, reply) => {
    const session = auth.session(request);
    if (!session) return reply.code(401).send({ error: "sign in required" });
    if (config.allowedOrg && session.orgId !== config.allowedOrg) return reply.code(403).send({ error: "access denied" });
    if (config.allowedEmails.size > 0) {
      const email = await auth.primaryEmail(request, session.userId).catch(() => null);
      if (!email?.verified || !config.allowedEmails.has(email.emailAddress.toLowerCase())) {
        return reply.code(403).send({ error: "access denied" });
      }
    }
  });
}