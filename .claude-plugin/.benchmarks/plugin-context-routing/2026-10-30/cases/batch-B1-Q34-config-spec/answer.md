| Setting | Main config (`test` inherits defaults) | Test environment config | Request spec expects | Job spec expects for test |
|---|---:|---:|---:|---:|
| Attempts | 5 | 2 | 2 | — |
| Delay (seconds) | 30 | 0 | 0 | 10 |
| Retry on timeout | true | false | false | — |

- **The test configurations differ on all three settings:** [config/report_delivery.yml](config/report_delivery.yml:1) defines defaults inherited by `test`; [config/environments/test_delivery.yml](config/environments/test_delivery.yml:1) supplies different values. Whether these override the defaults depends on the configuration loader.
- **The request spec matches the test environment config:** it expects `2`, `0`, and `false` in [report_delivery_spec.rb](spec/requests/report_delivery_spec.rb:3).
- **The job spec’s test delay disagrees with both configs and the request spec:** it expects **10 seconds** in [report_delivery_job_spec.rb](spec/jobs/report_delivery_job_spec.rb:10), whereas the configs specify **30** and **0**.
- **Production expectations agree:** the job spec expects `5` attempts, `30` seconds, and timeout retries enabled in [report_delivery_job_spec.rb](spec/jobs/report_delivery_job_spec.rb:2), matching production’s inherited defaults.
