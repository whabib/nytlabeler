# Built on Docker Hardened Images (https://dhi.io, free): minimal Alpine-based Node images
# with no known vulnerabilities. The -dev image has npm and a shell for building; the runtime
# image has neither, and runs as a non-root user. Both stages are Alpine (musl), so native
# modules (libsql) are installed for the libc they run on.

# Stage 1: Build
FROM dhi.io/node:24-alpine-dev AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
# Compile, then keep only the production dependencies for the runtime image
RUN npm run build && npm prune --omit=dev

# Stage 2: Production (no npm, no shell)
FROM dhi.io/node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/public ./src/public

EXPOSE 4100
CMD ["node", "dist/main.js"]
