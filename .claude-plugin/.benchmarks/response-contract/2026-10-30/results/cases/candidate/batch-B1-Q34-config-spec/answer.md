| Setting | Main config (`test` inherits defaults) | Test override | Request spec | Job spec |
|---|---:|---:|---:|---:|
| Attempts | 5 | 2 | 2 | — |
| Delay (seconds) | 30 | 0 | 0 | 10 |
| Retry on timeout | true | false | false | — |

- The [main config](config/report_delivery.yml) and [test override](config/environments/test_delivery.yml) differ on all three test settings. The [request spec](spec/requests/report_delivery_spec.rb:3) matches the test override.
- The [job spec’s test-delay expectation](spec/jobs/report_delivery_job_spec.rb:10) is **10 seconds**, disagreeing with both configs (30 and 0) and the request spec (0).
- The [job spec’s production expectations](spec/jobs/report_delivery_job_spec.rb:3)—5 attempts, 30 seconds, timeout retries enabled—match the [main config](config/report_delivery.yml).

These files alone don’t establish which config takes precedence at runtime.
