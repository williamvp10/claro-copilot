FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq libatomic1 libgomp1 libvulkan1 && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 lms
USER lms
WORKDIR /home/lms
RUN curl --fail --silent --show-error --location https://lmstudio.ai/install.sh --output /tmp/install-llmster.sh \
    && grep -qx 'APP_VERSION="0.1.1-2"' /tmp/install-llmster.sh \
    && bash /tmp/install-llmster.sh --no-modify-path \
    && rm /tmp/install-llmster.sh \
    && mkdir -p /home/lms/.lmstudio/models
COPY --chmod=755 start.sh /usr/local/bin/start-lm-studio
ENTRYPOINT ["/usr/local/bin/start-lm-studio"]
