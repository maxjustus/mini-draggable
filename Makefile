serve:
	python3 -m http.server 3813 --bind 127.0.0.1

check:
	npx tsc --noEmit

test:
	npx playwright test
