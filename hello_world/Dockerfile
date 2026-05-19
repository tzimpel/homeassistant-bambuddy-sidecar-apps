FROM ghcr.io/home-assistant/base:latest

# Copy data for app
COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]