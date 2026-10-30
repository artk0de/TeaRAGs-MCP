Да. Для маппинга `instead → Instead` и `gruntworx → GruntWorx` достаточно явного словаря, например:

```ruby
PROVIDER_NAMES = {
  instead: 'Instead',
  gruntworx: 'GruntWorx'
}.freeze
```

`downcase` для этих двух имён тоже даёт нужные ключи, но словарь задаёт соответствие явно и не зависит от правил преобразования регистра.