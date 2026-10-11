# Parley on Cloudflare Containers: Parley's own image (../Dockerfile, built first as parley:local)
# with two tools, because a container's disk starts empty every time it starts. Litestream copies
# the database to an R2 bucket as it changes and brings it back at start; tigrisfs keeps the files
# (uploads, files replies made, knowledge documents) in another R2 bucket. The build context is the
# repository (wrangler.jsonc's image_build_context).
ARG PARLEY_IMAGE=parley:local

FROM debian:trixie-slim AS tools
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
ARG TIGRISFS_VERSION=1.2.2
ARG TIGRISFS_SHA256=fd0c19c5c1d19eebd466cd4b6ce8f38286bedad6d792e6202cc3c916ce5e4281
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /tools
RUN curl -fsSL -o litestream.tar.gz "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
  && echo "${LITESTREAM_SHA256}  litestream.tar.gz" | sha256sum -c - \
  && tar -xzf litestream.tar.gz litestream \
  && curl -fsSL -o tigrisfs.tar.gz "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_amd64.tar.gz" \
  && echo "${TIGRISFS_SHA256}  tigrisfs.tar.gz" | sha256sum -c - \
  && tar -xzf tigrisfs.tar.gz tigrisfs

FROM ${PARLEY_IMAGE}
# Mounting the files bucket takes root; Parley runs inside Cloudflare's container sandbox.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fuse3 && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/fusermount3 /usr/local/bin/fusermount
COPY --from=tools /tools/litestream /tools/tigrisfs /usr/local/bin/
COPY cloudflare/litestream.yml /etc/litestream.yml
COPY cloudflare/start.sh /usr/local/bin/parley-start
# Every request comes through the Worker (src/index.ts), which sets X-Forwarded-For itself.
ENV TRUST_PROXY=1
# Cloudflare checks the container on its port instead.
HEALTHCHECK NONE
CMD ["sh", "/usr/local/bin/parley-start"]
