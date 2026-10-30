Да. Для этих двух провайдеров достаточно явного словаря:

```ruby
PROVIDER_NAMES = {
  instead: 'Instead',
  gruntworx: 'GruntWorx'
}.freeze
```

Тогда API-ключи `instead` и `gruntworx` остаются в lowercase, а отображаемые названия задаются явно. `camelize` здесь не нужен.