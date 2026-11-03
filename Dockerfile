FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LAB_HTTP_PORT=8766
WORKDIR /app
RUN groupadd --gid 1000 lab \
    && useradd --uid 1000 --gid lab --no-create-home lab \
    && mkdir /data && chown lab:lab /data
COPY --chown=lab:lab run-lab.py LICENSE ./
COPY --chown=lab:lab relay_lab ./relay_lab
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python3 -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('LAB_HTTP_PORT', '8766') + '/', timeout=3).close()"
ENTRYPOINT ["python3", "-B", "run-lab.py"]
CMD ["--help"]
