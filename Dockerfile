# Dockerfile (Optimized Version)

# =================
#  Builder Stage
# =================
# 这个阶段用于安装所有依赖，包括编译工具，最终产物会被复制到下一阶段
FROM python:3.9-slim-bullseye AS builder

# 安装编译Python包可能需要的构建工具，以及你指定的nmap和procps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    nmap \
    procps \
    && rm -rf /var/lib/apt/lists/*

# 为Python依赖创建一个独立的虚拟环境，便于管理和复制
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# 复制依赖文件并安装到虚拟环境中
# 这样可以利用缓存，如果 requirements.txt 不变，则此层不会重新执行
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


# =================
#  Final Stage
# =================
# 这个阶段用于构建最终的、轻量级的生产镜像
FROM python:3.9-slim-bullseye

# 创建一个非 root 用户来运行应用，这是关键的安全实践
RUN useradd --create-home appuser

# 从 builder 阶段复制必要的系统工具 (nmap, procps)
# 注意：我们需要找到这些工具及其所有依赖，这可能比较复杂。
# 一个更简单、更健壮的方法是直接在最终阶段也安装它们。
# 这样虽然镜像会稍大一点，但可靠性更高。
RUN apt-get update && apt-get install -y --no-install-recommends \
    nmap \
    procps \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /home/appuser/app

# 从 builder 阶段复制已安装的 Python 虚拟环境
ENV VIRTUAL_ENV=/opt/venv
COPY --from=builder $VIRTUAL_ENV $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# 复制应用代码
# 注意：源路径的 `app/` 和目标路径的 `./`
COPY app/ .

# 更改工作目录的所有权为新创建的用户
RUN chown -R appuser:appuser /home/appuser

# 切换到非 root 用户
USER appuser

# 设置环境变量 (已通过 VIRTUAL_ENV 简化 PYTHONPATH)
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV GEVENT_SUPPORT=True

# 暴露端口
EXPOSE 5000

# 启动命令保持不变，但现在它将以非 root 用户身份运行
CMD ["gunicorn", "--worker-class", "geventwebsocket.gunicorn.workers.GeventWebSocketWorker", "--workers", "2", "--threads", "4", "--bind", "0.0.0.0:5000", "--timeout", "120", "app:app"]
