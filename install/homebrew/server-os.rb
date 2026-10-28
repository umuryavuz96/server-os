# Homebrew formula for a tap (github.com/umuryavuz96/homebrew-tap):  brew install umuryavuz96/tap/server-os
# Update url + sha256 on each release (the release workflow prints the checksums in SHA256SUMS).
class ServerOS < Formula
  desc "Home server run by an AI agent: setup wizard, live panel, apps and jobs"
  homepage "https://github.com/umuryavuz96/server-os"
  url "https://github.com/umuryavuz96/server-os/releases/download/v0.1.0/server-os-v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_SHA256_OF_THE_RELEASE_TARBALL"
  license "MIT"

  depends_on "go" => :build
  depends_on "oven-sh/bun/bun"

  def install
    libexec.install Dir["*"]
    cd libexec/"setup" do
      system "go", "build", *std_go_args(output: libexec/"server-os-setup", ldflags: "-s -w -X main.version=v#{version}")
    end
    (bin/"server-os-setup").write <<~SH
      #!/bin/sh
      exec "#{libexec}/server-os-setup" --source "#{libexec}" "$@"
    SH
    (bin/"server-os").write <<~SH
      #!/bin/sh
      exec bun run "#{libexec}/server/cli.ts" "$@"
    SH
  end

  def caveats
    <<~EOS
      Run the setup wizard to lay out ~/server-os, install the service and pair your devices:
        server-os-setup
    EOS
  end

  test do
    assert_match "server-os-setup", shell_output("#{bin}/server-os-setup version")
  end
end
