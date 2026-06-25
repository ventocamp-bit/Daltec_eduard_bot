$body = Get-Content -Raw "raw_payload.json"
Invoke-RestMethod -Uri "https://angebote.daltec.at/api/eduard/inbound" -Method Post -Headers @{"x-ingest-secret"="8N24jWPIO0y5rGCLTnmfFXA9bxEQugtHl7qK3cMhV1ZJRSew"; "Content-Type"="application/json"} -Body $body
