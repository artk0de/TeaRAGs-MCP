- [ReportRetryPolicy#retry_timeout?](app/services/report_retry_policy.rb:4) permits retry only when `retry_on_timeout` is enabled **and** `attempt < attempts`. At the configured limit, it denies retry.
- [EmailDelivery#retry_timeout?](app/adapters/email_delivery.rb:8) delegates to its retry policy, passing `attempt` unchanged, so it follows that policy’s decision.
- [WebhookDelivery#retry_timeout?](app/adapters/webhook_delivery.rb:8) always returns `false`, regardless of settings or attempt number.

Thus, email can retry timeouts when its policy allows; webhook never retries timeouts through this method.
