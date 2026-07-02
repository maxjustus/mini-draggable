build:
	node build.js

check:
	npx tsc --noEmit
	npx tsc -p tests

fmt:
	npx prettier --write 'src/**/*.ts' 'tests/**/*.ts'

test:
	npx playwright test

serve:
	python3 -m http.server 3813 --bind 127.0.0.1
