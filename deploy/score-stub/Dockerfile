# deploy/score-stub/Dockerfile — standalone stub Score API (sprint-169)
# Build context is the repo root (Railway upload); only the stub dir is copied.
FROM node:22-slim
WORKDIR /app

COPY deploy/score-stub/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY deploy/score-stub/fixtures.ts deploy/score-stub/server.ts ./

ENV PORT=4010
EXPOSE 4010

HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4010/health',r=>{r.statusCode===200?process.exit(0):process.exit(1)}).on('error',()=>process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
