.PHONY: check install

check:
	@node --check src/codex.ts
	@node --check src/gateway.ts
	@node --check src/server.ts
	@node --check src/main.ts
	@node --test test/*.test.ts

install:
	@node src/main.ts install
