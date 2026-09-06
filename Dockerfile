# Plint.
#
# One long-running Node process. Not a serverless function: it holds a
# connection pool, sets a transaction-scoped identity on every request, and
# writes evidence photographs to a disk that has to still be there next time.
#
# Node 22 to match the engines field. sharp is a native dependency and resolves
# its own linux-x64 prebuild during npm ci, which is why the install happens
# inside the image rather than being copied in from a developer's machine.

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a code-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Where uploaded photographs live. Mount a volume here, or they are lost on
# every deploy and the completion certificates lose their thumbnails.
ENV PLINT_EVIDENCE_DIR=/data/evidence
RUN mkdir -p /data/evidence && chown -R node:node /data

USER node
EXPOSE 3000

# Migrations run, TLS is verified, then the server starts. See the script.
CMD ["node", "scripts/deploy-start.js"]
