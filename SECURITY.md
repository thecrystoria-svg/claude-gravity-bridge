# Security

agy-bridge opens no network port. It talks to Claude over stdio and to the Antigravity app over a loopback-only debug port. See "Security model" in the README.

While the debug port is on, any program running as your Windows user can control the app through it. Turn it off by restarting Antigravity normally.

To report a vulnerability, open a private security advisory on the GitHub repository (Security tab, "Report a vulnerability"). Please do not post details in a public issue.
