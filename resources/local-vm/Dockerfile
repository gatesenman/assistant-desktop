# Assistant Desktop 本地虚拟电脑：一键即用（中文、浏览器、工作区挂载、键鼠可控）
# v0.7：加入 AT-SPI 无障碍组件，智能体可读取控件树（编号点击更准确）
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 LANGUAGE=zh_CN:zh \
    DISPLAY=:0 GEOMETRY=1280x800x24 \
    HOME=/home/desk USER=desk
RUN apt-get update && apt-get install -y --no-install-recommends \
      locales fonts-noto-cjk fonts-noto-cjk-extra \
      xvfb x11vnc fluxbox xterm xdotool dbus-x11 scrot imagemagick \
      firefox \
      novnc websockify \
      ca-certificates curl procps python3 \
      thunar mousepad xclip \
      at-spi2-core python3-pyatspi gir1.2-atspi-2.0 libatk-adaptor libgail-common \
    && echo 'zh_CN.UTF-8 UTF-8' >> /etc/locale.gen \
    && locale-gen zh_CN.UTF-8 \
    && update-locale LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 \
    && (id -u desk >/dev/null 2>&1 || useradd -m -u 1001 -s /bin/bash desk) \
    && mkdir -p /workspace /home/desk/Desktop /home/desk/.fluxbox \
    && ln -sf /workspace /home/desk/Desktop/工作目录 \
    && printf 'session.screen0.toolbar.visible: false\n' > /home/desk/.fluxbox/init \
    && chown -R desk:desk /home/desk /workspace \
    && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/assistant-vm
RUN chmod +x /usr/local/bin/assistant-vm
EXPOSE 5900 6080
ENTRYPOINT ["/usr/local/bin/assistant-vm"]
