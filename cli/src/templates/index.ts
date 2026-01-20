import { AnalysisResult } from "../utils/analyze";

export interface DockerfileTemplate {
  name: string;
  content: string;
}

// Next.js Dockerfile (supports npm, yarn, pnpm)
function nextjsDockerfile(pm: "npm" | "yarn" | "pnpm" | "bun" | null, port: number): string {
  const packageManager = pm || "npm";

  if (packageManager === "pnpm") {
    return `FROM node:20-alpine AS base

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Dependencies stage
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build stage
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Production stage
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}

# Copy built assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE ${port}
CMD ["node", "server.js"]
`;
  }

  if (packageManager === "yarn") {
    return `FROM node:20-alpine AS base

# Dependencies stage
FROM base AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Build stage
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn build

# Production stage
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}

# Copy built assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE ${port}
CMD ["node", "server.js"]
`;
  }

  // npm (default)
  return `FROM node:20-alpine AS base

# Dependencies stage
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# Build stage
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production stage
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=${port}

# Copy built assets
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE ${port}
CMD ["node", "server.js"]
`;
}

// Express/Node.js Dockerfile
function expressDockerfile(pm: "npm" | "yarn" | "pnpm" | "bun" | null, port: number): string {
  const packageManager = pm || "npm";

  if (packageManager === "pnpm") {
    return `FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

ENV NODE_ENV=production
ENV PORT=${port}
EXPOSE ${port}

CMD ["node", "index.js"]
`;
  }

  if (packageManager === "yarn") {
    return `FROM node:20-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=${port}
EXPOSE ${port}

CMD ["node", "index.js"]
`;
  }

  // npm (default)
  return `FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY . .

ENV NODE_ENV=production
ENV PORT=${port}
EXPOSE ${port}

CMD ["node", "index.js"]
`;
}

// Python Flask/FastAPI Dockerfile
function pythonDockerfile(framework: string, port: number): string {
  if (framework === "fastapi") {
    return `FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=${port}
EXPOSE ${port}

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${port}"]
`;
  }

  if (framework === "django") {
    return `FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=${port}
EXPOSE ${port}

CMD ["gunicorn", "--bind", "0.0.0.0:${port}", "config.wsgi:application"]
`;
  }

  // Flask (default)
  return `FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=${port}
ENV FLASK_APP=app.py
EXPOSE ${port}

CMD ["gunicorn", "--bind", "0.0.0.0:${port}", "app:app"]
`;
}

// Go Dockerfile
function goDockerfile(port: number): string {
  return `FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/main .

FROM alpine:latest

WORKDIR /app
COPY --from=builder /app/main .

ENV PORT=${port}
EXPOSE ${port}

CMD ["./main"]
`;
}

// Simple Node.js Dockerfile (for generic nodejs)
function nodejsDockerfile(pm: "npm" | "yarn" | "pnpm" | "bun" | null, port: number): string {
  const packageManager = pm || "npm";

  if (packageManager === "pnpm") {
    return `FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

ENV PORT=${port}
EXPOSE ${port}

CMD ["node", "index.js"]
`;
  }

  return `FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY . .

ENV PORT=${port}
EXPOSE ${port}

CMD ["node", "index.js"]
`;
}

export function generateDockerfile(analysis: AnalysisResult): DockerfileTemplate | null {
  const { framework, packageManager, port } = analysis;

  if (!framework) {
    return null;
  }

  switch (framework.name) {
    case "nextjs":
      return {
        name: "Next.js",
        content: nextjsDockerfile(packageManager, port),
      };

    case "express":
    case "fastify":
    case "hono":
    case "nestjs":
      return {
        name: framework.name,
        content: expressDockerfile(packageManager, port),
      };

    case "nodejs":
      return {
        name: "Node.js",
        content: nodejsDockerfile(packageManager, port),
      };

    case "flask":
      return {
        name: "Flask",
        content: pythonDockerfile("flask", port),
      };

    case "fastapi":
      return {
        name: "FastAPI",
        content: pythonDockerfile("fastapi", port),
      };

    case "django":
      return {
        name: "Django",
        content: pythonDockerfile("django", port),
      };

    case "python":
      return {
        name: "Python",
        content: pythonDockerfile("flask", port),
      };

    case "go":
      return {
        name: "Go",
        content: goDockerfile(port),
      };

    default:
      return null;
  }
}

export function generateHostConfig(analysis: AnalysisResult): object {
  const config: any = {
    version: 1,
    port: analysis.port,
    dockerfile: "Dockerfile",
  };

  // Add volumes if needed
  const volumeRequirements = analysis.requirements.filter((r) => r.type === "persistent_volume");
  if (volumeRequirements.length > 0) {
    config.volumes = {};
    for (const req of volumeRequirements) {
      if (req.path) {
        config.volumes[req.path] = "persistent";
      }
    }
  }

  // Add env vars if needed
  const envRequirements = analysis.requirements.filter((r) => r.type === "env_var");
  if (envRequirements.length > 0) {
    config.env = {};
    for (const req of envRequirements) {
      if (req.name && req.suggested) {
        config.env[req.name] = req.suggested;
      }
    }
  }

  return config;
}
