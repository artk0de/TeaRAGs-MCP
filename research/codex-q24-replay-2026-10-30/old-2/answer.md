Да, согласен. Для этих двух провайдеров достаточно явного словаря:

```ruby
PROVIDER_NAMES = {
  instead: 'Instead',
  gruntworx: 'GruntWorx'
}.freeze
```

Ключ можно нормализовать через `downcase.to_sym`, затем искать в словаре. `camelize` здесь не нужен: отображаемые имена заданы явно и не выводятся из названий namespace.