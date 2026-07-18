# Loon规则

有一些比较极端，仅适合个人使用，仅供参考。

## 域名类规则

### DOMAIN

匹配整个域名

```
DOMAIN,google.com,proxy
```

### DOMAIN-SUFFIX

匹配域名后缀，例如apple.com可以匹配icloud.apple.com，www.apple.com，但是不能够匹配app-apple.com

```
DOMAIN-SUFFIX,apple.com,proxy
```

### DOMAIN-KEYWORD

域名关键词匹配

```
DOMAIN-KEYWORD,apple,proxy
```

## HTTP类规则

HTTP类型的规则只会对HTTP、HTTPS类型的请求进行匹配

### URL-REGEX

根据提供的正则表达式对请求的url进行匹配

``` 
URL-REGEX,^http://google\.com,PROXY
```

### USER-AGENT

根据请求header中的user-agent进行匹配，支持通配符

``` 
USER-AGENT,Apple*,DIRECT
```

## 更多

参考：https://nsloon.app/docs/category/%E8%A7%84%E5%88%99