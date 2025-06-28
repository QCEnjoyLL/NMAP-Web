FROM python:3.9-slim

# 安装nmap和其他必要的包
RUN apt-get update && apt-get install -y \
    nmap \
    procps \
    && rm -rf /var/lib/apt/lists/*

# 创建工作目录
WORKDIR /app

# 复制依赖文件并安装
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY app/ ./app/

# 设置环境变量
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV GEVENT_SUPPORT=True

# 暴露端口
EXPOSE 5000

# 启动命令，使用gevent-websocket作为WSGI服务器，支持WebSocket和多线程
CMD ["gunicorn", "--worker-class", "geventwebsocket.gunicorn.workers.GeventWebSocketWorker", "--workers", "2", "--threads", "4", "--bind", "0.0.0.0:5000", "--timeout", "120", "app.app:app"] 