# The team computer's software, built into its image instead of installed when
# it first boots: the desktop and VNC, Google Chrome, and agent-browser.
#
# Nothing here is required. The computer's own installer (`bot-computer install`
# in agent/lib/computer/script.ts) checks the same things on every machine and
# installs whatever is missing, so a machine from this image starts in seconds
# and one without it still works, only slower the first time.
#
# Keep in step with script.ts: PACKAGES there, and the agent-browser version in
# @agent-browser/sandbox. tests/computer-image.test.ts checks both.
#
# Local Docker builds it for this machine's CPU through eve
# (DockerSandbox.dockerfile()). For Vercel Sandbox, build it for linux/amd64 and
# push it to Vercel Container Registry, then set BOT_COMPUTER_IMAGE:
#   vercel vcr build docker agent/sandbox --push

ARG EVE_IMAGE=ghcr.io/vercel/eve:0.79.1
FROM ${EVE_IMAGE}

USER root
ARG DEBIAN_FRONTEND=noninteractive

# The screens, the desktop, the shell's fence, and fonts (PACKAGES in script.ts).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server websockify xdotool x11-utils x11-xserver-utils xauth \
      iptables nftables fonts-noto-core fonts-noto-color-emoji fonts-liberation \
      ca-certificates curl openbox tint2 pcmanfm xfce4-terminal dbus-x11 \
 && rm -rf /var/lib/apt/lists/*

# Google Chrome, for this CPU.
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL -o /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_${arch}.deb" \
 && apt-get update \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/*

# agent-browser, where eve's installer puts it (the sandbox user's npm prefix).
USER vercel-sandbox
RUN npm install -g agent-browser@0.40.0

WORKDIR /workspace
