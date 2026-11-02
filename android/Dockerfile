# Compila o APK sem instalar nada no Mac: docker compose --profile build run --rm android-build
# (amd64 porque as ferramentas de build do Android para Linux só existem para x86_64; no Mac com Apple Silicon roda emulado.)
FROM --platform=linux/amd64 eclipse-temurin:17-jdk-jammy
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
RUN curl -fsSL https://services.gradle.org/distributions/gradle-8.7-bin.zip -o /tmp/g.zip \
    && unzip -q /tmp/g.zip -d /opt && ln -s /opt/gradle-8.7/bin/gradle /usr/local/bin/gradle && rm /tmp/g.zip
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
    && curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/c.zip \
    && unzip -q /tmp/c.zip -d $ANDROID_HOME/cmdline-tools && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest && rm /tmp/c.zip
RUN yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null \
    && $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
WORKDIR /work/android
