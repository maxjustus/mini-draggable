check:
	npx tsc --noEmit

fmt:
	npx prettier --write '*.js' 'tests/**/*.js'

test:
	npx playwright test

serve:
	python3 -m http.server 3813 --bind 127.0.0.1
