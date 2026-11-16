FROM debian:trixie-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates ccache cmake git libboost-dev python3 \
    && rm -rf /var/lib/apt/lists/*
ARG BITCOIN_REPO=https://github.com/pseudoramdom/bitcoin.git
ARG BITCOIN_REVISION=77c5e1f7ca0b7e566a819a59e58090aee5c13975
ARG BUILD_JOBS=2
ARG BITCOIN_NETWORK=testnet4
WORKDIR /src
RUN test "${#BITCOIN_REVISION}" -eq 40 \
    && printf '%s' "$BITCOIN_REVISION" | grep -Eq '^[0-9a-f]{40}$' \
    && git init . \
    && git remote add origin "$BITCOIN_REPO" \
    && git fetch --depth=1 origin "$BITCOIN_REVISION" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$BITCOIN_REVISION"
RUN cmake -S . -B build -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=RelWithDebInfo -DWITH_CCACHE=ON \
    -DENABLE_WALLET=OFF -DENABLE_IPC=OFF -DBUILD_GUI=OFF \
    -DBUILD_TESTS=OFF -DBUILD_BENCH=OFF \
    && cmake --build build --parallel "$BUILD_JOBS" --target bitcoind bitcoin-cli \
    && strip build/bin/bitcoind build/bin/bitcoin-cli \
    && build/bin/bitcoind "-$BITCOIN_NETWORK" -datadir=/tmp -conf=/dev/null -nosettings -help | grep -q -- '-staletips'

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 bitcoin \
    && useradd --uid 1000 --gid bitcoin --no-create-home bitcoin \
    && mkdir /data && chown bitcoin:bitcoin /data
ARG BITCOIN_REPO=https://github.com/pseudoramdom/bitcoin.git
ARG BITCOIN_REVISION=77c5e1f7ca0b7e566a819a59e58090aee5c13975
LABEL org.opencontainers.image.source="$BITCOIN_REPO" \
      org.opencontainers.image.revision="$BITCOIN_REVISION"
COPY --from=build /src/build/bin/bitcoind /src/build/bin/bitcoin-cli /usr/local/bin/
COPY --from=build /src/COPYING /usr/share/doc/bitcoin/COPYING
USER 1000:1000
ENTRYPOINT ["bitcoind"]
CMD ["-datadir=/data", "-conf=/dev/null", "-nosettings", "-help"]
