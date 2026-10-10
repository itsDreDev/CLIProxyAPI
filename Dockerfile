FROM node:24-bookworm-slim AS gui-builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY gui/package.json gui/package-lock.json ./gui/
RUN npm ci --prefix gui --no-audit --no-fund
COPY gui ./gui
RUN npm run build --prefix gui

FROM golang:1.26-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends build-essential git && rm -rf /var/lib/apt/lists/*

COPY go.mod go.sum ./

RUN go mod download

COPY . .
COPY --from=gui-builder /app/internal/subscriptiongui/web ./internal/subscriptiongui/web

ARG VERSION=dev
ARG COMMIT=none
ARG BUILD_DATE=unknown

RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false -ldflags="-s -w -X 'main.Version=${VERSION}' -X 'main.Commit=${COMMIT}' -X 'main.BuildDate=${BUILD_DATE}'" -o ./CLIProxyAPI ./cmd/server/

FROM debian:bookworm

RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates curl && rm -rf /var/lib/apt/lists/*

RUN mkdir /CLIProxyAPI

COPY --from=builder ./app/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI

COPY config.example.yaml /CLIProxyAPI/config.example.yaml
COPY LICENSE /usr/share/licenses/cliproxyapi/LICENSE

WORKDIR /CLIProxyAPI

EXPOSE 8317

ENV TZ=Etc/UTC

RUN ln -snf /usr/share/zoneinfo/${TZ} /etc/localtime && echo "${TZ}" > /etc/timezone

CMD ["./CLIProxyAPI", "--config", "/CLIProxyAPI/config/config.yaml", "--local-model"]
