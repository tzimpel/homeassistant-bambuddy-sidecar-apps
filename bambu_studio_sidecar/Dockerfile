# BambuStudio variant of orca-slicer-api.
#
# Same Node wrapper code as the OrcaSlicer image — the wrapper is
# slicer-agnostic, it just shells out to whatever binary `ORCASLICER_PATH`
# points at via `--load-settings` / `--slice` (which BambuStudio's CLI
# accepts identically). Only the bundled AppImage differs.
#
# Build:
#   docker build -f Dockerfile.bambu-studio --build-arg BAMBU_VERSION=02.06.00.51 \
#                -t ghcr.io/maziggy/bambu-studio-api:latest .
#
# AMD64 only — BambuStudio doesn't publish an official ARM64 AppImage.

FROM node:22-bookworm AS build

ARG BAMBU_VERSION=02.06.00.51
ARG TARGETARCH

WORKDIR /app

RUN if [ "$TARGETARCH" = "arm64" ]; then \
        echo "ARM64 not supported — BambuStudio has no official ARM64 AppImage."; \
        exit 1; \
    fi; \
    echo "Downloading BambuStudio v${BAMBU_VERSION}..."; \
    curl -fL -o bambu.AppImage \
        "https://github.com/bambulab/BambuStudio/releases/download/v${BAMBU_VERSION}/Bambu_Studio_linux_fedora-v${BAMBU_VERSION}.AppImage"; \
    chmod +x bambu.AppImage; \
    ./bambu.AppImage --appimage-extract; \
    rm bambu.AppImage

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ghcr.io/home-assistant/base-ubuntu:22.04

# BambuStudio is built against webkit2gtk-4.0 (Ubuntu 22.04 era); 24.04
# only ships 4.1, so the runtime image stays on 22.04.
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       nodejs \
       libgl1 libgl1-mesa-dri libegl1 libopengl0 libglu1-mesa libosmesa6 \
       libsm6 libice6 libmspack0 libsoup2.4-1 \
       libgtk-3-0 \
       libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
       libwebkit2gtk-4.0-37 \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist/src /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/squashfs-root /app/squashfs-root

ENV PORT=3000
# `ORCASLICER_PATH` is the wrapper's slicer-binary env var, regardless of
# which slicer is bundled. Point it at the extracted BambuStudio AppRun.
ENV ORCASLICER_PATH=/app/squashfs-root/AppRun
ENV DATA_PATH=/app/data
ENV NODE_ENV=production
# Bundled BBL profiles live under the same path inside BambuStudio.
ENV BUNDLED_PROFILES_PATH=/app/squashfs-root/resources/profiles/BBL

EXPOSE 3000

CMD ["node", "app/dist/index.js"]
