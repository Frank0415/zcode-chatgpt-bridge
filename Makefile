.PHONY: check install

check:
	@node --check src/log.ts
	@node --check src/runtime.ts
	@node --check src/codex.ts
	@node --check src/gateway.ts
	@node --check src/server.ts
	@node --check src/main.ts
	@BRIDGE_LOG_LEVEL=error node --test test/*.test.ts

install:
	@node src/main.ts install
