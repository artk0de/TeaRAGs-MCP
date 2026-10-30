| Setting | Main config’s `test` values | Test environment config | Request spec expects |
|---|---:|---:|---:|
| Attempts | 5 | 2 | 2 |
| Delay (seconds) | 30 | 0 | 0 |
| Retry on timeout | true | false | false |

The disagreements are:

- The main config’s `test` section inherits **5 attempts, 30 seconds, timeout retries enabled**, differing on all three values from the test environment config and request spec. See [main config](config/report_delivery.yml:1), [test environment config](config/environments/test_delivery.yml:1), and [request spec](spec/requests/report_delivery_spec.rb:3).
- The job spec expects a **10-second test delay**, conflicting with both the test environment config and request spec (**0 seconds**), and the main config’s inherited value (**30 seconds**). See [job spec](spec/jobs/report_delivery_job_spec.rb:10).

The production expectations in the [job spec](spec/jobs/report_delivery_job_spec.rb:2) agree with the [main config](config/report_delivery.yml:6): **5 attempts, 30 seconds, timeout retries enabled**.

These files alone don’t establish which test configuration takes precedence at runtime.
