#!/bin/sh
# 墨忆容器入口脚本
# 从挂载目录读取 env 文件，注入凭据后启动 node server.js。
# 凭据不进镜像，运行时才注入——这是容器化部署的安全底线。

set -e

# 凭据目录：用户通过 -v 挂载进来，默认 /data/moyi-env
ENV_DIR="${MOYI_ENV_DIR:-/data/moyi-env}"

# 遍历目录下所有 *.env 和 moyi.env，按文件名排序。
# 后读的不覆盖已设置的值——与 server.js 的 .env.local 语义一致（先到先得）。
if [ -d "$ENV_DIR" ]; then
  # 收集文件名列表，排序后逐个处理
  filelist=""
  for f in "$ENV_DIR"/*.env "$ENV_DIR"/moyi.env; do
    [ -f "$f" ] || continue
    filelist="$filelist
$f"
  done
  # 去重（moyi.env 可能已被 *.env 匹配）并排序
  # 注意：文件名不含空格（来自 glob 模式），按换行分割安全
  filelist=$(printf '%s\n' "$filelist" | sed '/^$/d' | sort -u)

  for f in $filelist; do
    # 逐行解析，不用 eval/source，杜绝命令注入
    while IFS= read -r line || [ -n "$line" ]; do
      # 跳过空行和注释（先剥前导空白再判断 #）
      line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//')
      case "$line" in
        ''|'#'*) continue ;;
      esac
      # 必须含 = 且左边是合法变量名（^[A-Za-z_][A-Za-z0-9_]*=）
      key=$(printf '%s' "$line" | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p')
      [ -z "$key" ] && continue
      # 取 = 之后的部分作为值（保留值中所有的 = 和特殊字符）
      value=$(printf '%s' "$line" | sed 's/^[^=]*=//')
      # 去掉值两侧的成对引号（单引号或双引号）
      case "$value" in
        \"*\") value=$(printf '%s' "$value" | sed 's/^"//;s/"$//') ;;
        \'*\') value=$(printf '%s' "$value" | sed "s/^'//;s/'$//") ;;
      esac
      # 仅当变量当前未设置时才 export（先到先得）
      # printenv 返回 0 表示变量已设置（哪怕值为空），返回 1 表示未设置
      if ! printenv "$key" >/dev/null 2>&1; then
        export "${key}=${value}"
      fi
    done < "$f"
  done
fi

# 诊断：缺关键凭据时给出中文提示，但仍然启动（server.js 自己有缺配置的运行时诊断）
# 后端可换，所以两组变量名都要认：自托管用 MOYI_DB_*，云端用 SUPABASE_*。
missing=""
if [ -z "$MOYI_DB_URL" ] && [ -z "$SUPABASE_URL" ]; then missing="$missing MOYI_DB_URL"; fi
if [ -z "$MOYI_DB_TOKEN" ] && [ -z "$SUPABASE_KEY" ] && [ -z "$SUPABASE_ANON_KEY" ]; then
  missing="$missing MOYI_DB_TOKEN"
fi
if [ -n "$missing" ]; then
  echo ""
  echo "  ⚠ 墨忆：缺少环境变量:$missing"
  echo "    请将包含这些变量的 .env 文件放入挂载目录（默认 /data/moyi-env），"
  echo "    或通过 docker run -e 传入。"
  echo "    自托管栈：MOYI_DB_URL=http://postgrest:3000 + MOYI_DB_TOKEN=<非空串>"
  echo "    Supabase ：SUPABASE_URL=... + SUPABASE_KEY=<service_role key>"
  echo "    服务仍将启动，但未配置时所有 API 调用会返回 500。"
  echo ""
fi

# exec 替换当前进程为 node，让 PID 1 收到 SIGTERM 时能优雅停止
exec node server.js
