-- Studio desktop app: makes sure the local Studio server is running (no Terminal
-- window) and opens it in its own Chrome app window. A TEMPLATE: launcher/build_app.sh fills
-- the app name, repo folder and logs folder placeholders (scripts/studio-identity.sh) and compiles it; rebuild after editing.
-- The address comes from start.sh (it prints Studio's URL with the configured STUDIO_PORT), so no port is built in.
on run
	set repoDir to "__REPO__"
	set studioURL to ""
	try
		set studioURL to do shell script quoted form of (repoDir & "/launcher/start.sh")
	on error
		display alert "__APP_NAME__ did not start" message "Details are in __LOGS__ (web.log, worker.log, launcher.log)."
		return
	end try
	if studioURL does not start with "http://127.0.0.1:" then
		display alert "__APP_NAME__ did not start" message "Details are in __LOGS__ (web.log, worker.log, launcher.log)."
		return
	end if
	try
		do shell script "test -d " & quoted form of "/Applications/Google Chrome.app"
		do shell script "open -na 'Google Chrome' --args --app=" & quoted form of studioURL
	on error
		open location studioURL
	end try
end run
