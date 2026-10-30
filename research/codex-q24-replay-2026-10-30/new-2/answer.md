Да, для этих двух провайдеров явный словарь будет понятнее и надёжнее:

```ruby
PROVIDER_LABELS = {
  instead: 'Instead',
  gruntworx: 'GruntWorx'
}.freeze
```

Тогда `:instead` отображается как `Instead`, а `:gruntworx` — как `GruntWorx`; `camelize` не нужен. `downcase` даст обратный результат (`instead`, `gruntworx`), если исходное значение уже `Instead`/`GruntWorx`.