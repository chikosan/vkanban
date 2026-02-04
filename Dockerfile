# Stage 1: Planner
FROM lukemathwalker/cargo-chef:latest-rust-nightly AS planner
WORKDIR /app
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# Stage 2: Caching & Building Backend
FROM lukemathwalker/cargo-chef:latest-rust-nightly AS builder
WORKDIR /app

# Install system dependencies for SQLx and other crates
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    clang \
    libclang-dev \
    && rm -rf /var/lib/apt/lists/*

# Build dependencies - this is the layer that will be cached
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# Build the actual application
COPY . .
RUN cargo build --release --bin server

# Stage 3: Frontend Build
FROM node:22-slim AS frontend-builder
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/
COPY npx-cli/package.json ./npx-cli/
RUN pnpm install --frozen-lockfile

COPY . .
RUN npm run generate-types
RUN cd frontend && pnpm run build

# Stage 4: Runtime
FROM debian:bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    tini \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1001 appgroup && \
    useradd -u 1001 -g appgroup -s /bin/sh appuser

# Copy binaries and assets
COPY --from=builder /app/target/release/server /usr/local/bin/server
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

RUN mkdir -p /repos && chown -R appuser:appgroup /repos /app
USER appuser

ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["server"]