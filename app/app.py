from flask import Flask, render_template, request, jsonify
import subprocess
import json
import re
import os
import time
import threading
import uuid
import ipaddress
import math
import queue
from werkzeug.middleware.proxy_fix import ProxyFix
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
app.config['SECRET_KEY'] = os.urandom(24)
socketio = SocketIO(app, 
                   cors_allowed_origins="*", 
                   async_mode='gevent',
                   logger=True, 
                   engineio_logger=True,
                   ping_timeout=60,
                   ping_interval=25,
                   always_connect=True)

# 存储活动扫描任务
active_scans = {}

# 默认并行任务数
DEFAULT_PARALLEL_TASKS = 8
MIN_PARALLEL_TASKS = 4
MAX_PARALLEL_TASKS = 16

# 安全考虑：限制允许扫描的端口范围和常见选项
ALLOWED_OPTIONS = {
    # 扫描类型
    "-sS": "SYN扫描",
    "-sT": "TCP连接扫描",
    "-sU": "UDP扫描",
    "-sV": "服务版本检测",
    "-O": "操作系统检测",
    "-A": "综合扫描",
    
    # 扫描速度
    "-T0": "偷偷摸摸扫描",
    "-T1": "鬼鬼祟祟扫描",
    "-T2": "礼貌扫描",
    "-T3": "普通扫描",
    "-T4": "激进扫描"
}

@app.route('/')
def index():
    return render_template('index.html')

def is_valid_target(target):
    pattern = r'^[a-zA-Z0-9][a-zA-Z0-9\.\-\/]+$'
    return bool(re.match(pattern, target))

def is_valid_ports(ports):
    if not ports:
        return True
    
    if ports == "all" or ports == "-":
        return True
    
    pattern = r'^(?:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)?$'
    return bool(re.match(pattern, ports))

def split_ip_range(target, num_chunks):
    try:
        if '/' in target:
            network = ipaddress.ip_network(target, strict=False)
            total_ips = network.num_addresses
            if total_ips < num_chunks:
                num_chunks = max(1, total_ips)
            ips_per_chunk = math.ceil(total_ips / num_chunks)
            
            chunks = []
            start_ip = int(network.network_address)
            for i in range(num_chunks):
                chunk_start = start_ip + i * ips_per_chunk
                chunk_end = min(start_ip + (i + 1) * ips_per_chunk - 1, int(network.broadcast_address))
                
                if chunk_start <= chunk_end:
                    start_ip_obj = ipaddress.ip_address(chunk_start)
                    end_ip_obj = ipaddress.ip_address(chunk_end)
                    
                    if chunk_start == chunk_end:
                        chunks.append(str(start_ip_obj))
                    else:
                        chunks.append(f"{start_ip_obj}-{end_ip_obj}")
            
            return chunks
        
        elif '-' in target:
            start_ip, end_ip = target.split('-')
            start_ip = ipaddress.ip_address(start_ip.strip())
            end_ip = ipaddress.ip_address(end_ip.strip())
            
            total_ips = int(end_ip) - int(start_ip) + 1
            if total_ips < num_chunks:
                num_chunks = max(1, total_ips)
                
            ips_per_chunk = math.ceil(total_ips / num_chunks)
            
            chunks = []
            for i in range(num_chunks):
                chunk_start = int(start_ip) + i * ips_per_chunk
                chunk_end = min(int(start_ip) + (i + 1) * ips_per_chunk - 1, int(end_ip))
                
                if chunk_start <= chunk_end:
                    start_ip_obj = ipaddress.ip_address(chunk_start)
                    end_ip_obj = ipaddress.ip_address(chunk_end)
                    
                    if chunk_start == chunk_end:
                        chunks.append(str(start_ip_obj))
                    else:
                        chunks.append(f"{start_ip_obj}-{end_ip_obj}")
            
            return chunks
    except:
        pass
    
    return [target]

def split_port_range(ports, num_chunks):
    if not ports or ports == "all" or ports == "-":
        total_ports = 65535
        ports_per_chunk = math.ceil(total_ports / num_chunks)
        
        chunks = []
        for i in range(num_chunks):
            start_port = i * ports_per_chunk + 1
            end_port = min((i + 1) * ports_per_chunk, 65535)
            chunks.append(f"{start_port}-{end_port}")
        
        return chunks
    
    port_list = []
    for port_range in ports.split(','):
        if '-' in port_range:
            start, end = map(int, port_range.split('-'))
            port_list.extend(range(start, end + 1))
        else:
            port_list.append(int(port_range))
    
    if len(port_list) < num_chunks:
        num_chunks = max(1, len(port_list))
    
    chunks = []
    ports_per_chunk = math.ceil(len(port_list) / num_chunks)
    
    for i in range(num_chunks):
        start_idx = i * ports_per_chunk
        end_idx = min((i + 1) * ports_per_chunk, len(port_list))
        
        if start_idx < len(port_list):
            chunk_ports = sorted(port_list[start_idx:end_idx])
            if not chunk_ports:
                continue
                
            ranges = []
            range_start = chunk_ports[0]
            prev = chunk_ports[0]
            
            for port in chunk_ports[1:]:
                if port == prev + 1:
                    prev = port
                    continue
                
                if range_start == prev:
                    ranges.append(str(range_start))
                else:
                    ranges.append(f"{range_start}-{prev}")
                
                range_start = port
                prev = port
            
            if range_start == prev:
                ranges.append(str(range_start))
            else:
                ranges.append(f"{range_start}-{prev}")
            
            chunks.append(','.join(ranges))
    
    return chunks

def execute_nmap_scan(scan_id, target, ports, options, task_id, result_queue):
    try:
        command = ["nmap"] + options
        
        if ports:
            command.extend(["-p", ports])
        
        command.append(target)
        command_str = " ".join(command)
        
        socketio.emit('scan_update', {
            'scan_id': scan_id,
            'task_id': task_id,
            'status': 'task_running',
            'message': f'子任务 {task_id}: 扫描 {target} 端口 {ports if ports else "默认"}...',
            'command': command_str
        }, room=scan_id)
        
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        
        results = []
        errors = []
        
        for line in iter(process.stdout.readline, ''):
            results.append(line)
            if len(results) % 10 == 0:
                socketio.emit('scan_update', {
                    'scan_id': scan_id,
                    'task_id': task_id,
                    'status': 'task_progress',
                    'partial_result': line
                }, room=scan_id)
        
        for line in iter(process.stderr.readline, ''):
            errors.append(line)
        
        process.wait()
        
        result_data = {
            'task_id': task_id,
            'target': target,
            'ports': ports,
            'command': command_str,
            'success': process.returncode == 0,
            'result': ''.join(results),
            'error': ''.join(errors)
        }
        
        result_queue.put(result_data)
        
        socketio.emit('scan_update', {
            'scan_id': scan_id,
            'task_id': task_id,
            'status': 'task_completed',
            'message': f'子任务 {task_id} 已完成'
        }, room=scan_id)
        
    except Exception as e:
        error_msg = str(e)
        socketio.emit('scan_update', {
            'scan_id': scan_id,
            'task_id': task_id,
            'status': 'task_error',
            'message': f'子任务 {task_id} 出错: {error_msg}'
        }, room=scan_id)
        
        result_queue.put({
            'task_id': task_id,
            'target': target,
            'ports': ports,
            'success': False,
            'error': error_msg
        })

def run_nmap_scan(scan_id, target, ports, selected_options, scan_all_ports, parallel_tasks):
    try:
        num_threads = min(parallel_tasks, MAX_PARALLEL_TASKS)
        
        options = list(selected_options)
        
        if scan_all_ports:
            ports = "-"
        
        socketio.emit('scan_update', {
            'scan_id': scan_id,
            'status': 'starting',
            'message': f'正在使用 {num_threads} 个线程开始扫描...',
            'threads': num_threads
        }, room=scan_id)
        
        targets = split_ip_range(target, num_threads)
        
        if len(targets) == 1:
            port_chunks = split_port_range(ports, num_threads)
            tasks = [(targets[0], port) for port in port_chunks]
        else:
            tasks = [(t, ports) for t in targets]
        
        result_queue = queue.Queue()
        
        threads = []
        
        active_scans[scan_id]['total_tasks'] = len(tasks)
        active_scans[scan_id]['completed_tasks'] = 0
        active_scans[scan_id]['tasks'] = {}
        
        task_info = []
        for i, (task_target, task_ports) in enumerate(tasks):
            task_id = f"task_{i+1}"
            task_info.append({
                'task_id': task_id,
                'target': task_target,
                'ports': task_ports if task_ports else '默认端口'
            })
            
            active_scans[scan_id]['tasks'][task_id] = {
                'status': 'pending',
                'target': task_target,
                'ports': task_ports
            }
        
        socketio.emit('scan_update', {
            'scan_id': scan_id,
            'status': 'tasks_created',
            'message': f'已创建 {len(tasks)} 个扫描子任务',
            'tasks': task_info
        }, room=scan_id)
        
        for i, (task_target, task_ports) in enumerate(tasks):
            task_id = f"task_{i+1}"
            thread = threading.Thread(
                target=execute_nmap_scan, 
                args=(scan_id, task_target, task_ports, options, task_id, result_queue)
            )
            thread.daemon = True
            threads.append(thread)
        
        for thread in threads:
            thread.start()
            time.sleep(0.2)
        
        for thread in threads:
            thread.join()
        
        all_results = []
        all_errors = []
        
        while not result_queue.empty():
            result = result_queue.get()
            
            if result.get('success', False):
                all_results.append({
                    'target': result.get('target', ''),
                    'ports': result.get('ports', ''),
                    'result': result.get('result', '')
                })
            else:
                all_errors.append(result.get('error', ''))
        
        if all_errors:
            socketio.emit('scan_update', {
                'scan_id': scan_id,
                'status': 'error',
                'message': '扫描过程中出现错误',
                'error': '\n'.join(all_errors)
            }, room=scan_id)
        else:
            combined_result = merge_scan_results(all_results)
            
            socketio.emit('scan_update', {
                'scan_id': scan_id,
                'status': 'completed',
                'message': '扫描完成',
                'result': combined_result
            }, room=scan_id)
            
    except Exception as e:
        socketio.emit('scan_update', {
            'scan_id': scan_id,
            'status': 'error',
            'message': f'扫描过程中出错: {str(e)}'
        }, room=scan_id)
    
    if scan_id in active_scans:
        del active_scans[scan_id]

def merge_scan_results(results):
    if not results:
        return ""
    
    if len(results) == 1:
        return results[0]['result']
    
    open_ports = {}
    scan_headers = {}
    scan_footers = {}
    
    header_pattern = re.compile(r'Starting Nmap.*?(?=PORT)', re.DOTALL)
    ports_pattern = re.compile(r'PORT\s+STATE\s+SERVICE.*?(?=\n\n|\nNmap done:)', re.DOTALL)
    footer_pattern = re.compile(r'Nmap done:.*$', re.DOTALL)
    port_line_pattern = re.compile(r'^(\d+/\w+)\s+(\w+)\s+(.*)$', re.MULTILINE)
    
    for result_data in results:
        result_text = result_data['result']
        target = result_data['target']
        
        header_match = header_pattern.search(result_text)
        if header_match:
            header = header_match.group(0).strip()
            scan_headers[target] = header
        
        ports_match = ports_pattern.search(result_text)
        if ports_match:
            ports_section = ports_match.group(0)
            port_lines = ports_section.split('\n')[1:]
            
            for line in port_lines:
                port_match = port_line_pattern.match(line.strip())
                if port_match:
                    port, state, service = port_match.groups()
                    if target not in open_ports:
                        open_ports[target] = {}
                    open_ports[target][port] = {'state': state, 'service': service}
        
        footer_match = footer_pattern.search(result_text)
        if footer_match:
            footer = footer_match.group(0).strip()
            scan_footers[target] = footer
    
    combined_output = []
    
    if scan_headers:
        main_header = next(iter(scan_headers.values()))
        combined_output.append(main_header)
        combined_output.append("\nPORT\tSTATE\tSERVICE")
    
    for target, ports in open_ports.items():
        if len(open_ports) > 1:
            combined_output.append(f"\n目标: {target}")
        
        for port, info in sorted(ports.items(), key=lambda x: int(x[0].split('/')[0])):
            combined_output.append(f"{port}\t{info['state']}\t{info['service']}")
    
    if scan_footers:
        total_time = 0
        total_hosts = 0
        for footer in scan_footers.values():
            time_match = re.search(r'scanned in ([\d\.]+) seconds', footer)
            if time_match:
                total_time += float(time_match.group(1))
            
            hosts_match = re.search(r'(\d+) IP address', footer)
            if hosts_match:
                total_hosts += int(hosts_match.group(1))
        
        combined_output.append(f"\nNmap 多线程扫描完成: 总共扫描 {total_hosts} 个IP地址，用时 {total_time:.2f} 秒")
    
    return "\n".join(combined_output)

@socketio.on('connect')
def handle_connect():
    print(f"客户端已连接: {request.sid}, 传输方式: {request.environ.get('wsgi.websocket') and 'WebSocket' or '轮询'}")
    emit('connection_response', {
        'status': 'connected',
        'transport': request.environ.get('wsgi.websocket') and 'websocket' or 'polling',
        'sid': request.sid
    })

@socketio.on('join_scan')
def handle_join(data):
    scan_id = data['scan_id']
    if scan_id:
        print(f"Client joined scan room: {scan_id}")
        socketio.server.enter_room(request.sid, scan_id)

@socketio.on('start_scan')
def handle_scan_request(data):
    if not data:
        emit('scan_update', {'status': 'error', 'message': '没有提供数据'})
        return
    
    target = data.get('target', '')
    ports = data.get('ports', '')
    selected_options = data.get('options', [])
    scan_all_ports = data.get('scan_all_ports', False)
    parallel_tasks = data.get('parallel_tasks', DEFAULT_PARALLEL_TASKS)
    
    try:
        parallel_tasks = int(parallel_tasks)
        parallel_tasks = max(MIN_PARALLEL_TASKS, min(parallel_tasks, MAX_PARALLEL_TASKS))
    except:
        parallel_tasks = DEFAULT_PARALLEL_TASKS
    
    if not target or not is_valid_target(target):
        emit('scan_update', {'status': 'error', 'message': '无效的目标格式'})
        return
    
    if not is_valid_ports(ports):
        emit('scan_update', {'status': 'error', 'message': '无效的端口格式'})
        return
    
    valid_options = []
    for option in selected_options:
        if option in ALLOWED_OPTIONS:
            valid_options.append(option)
        else:
            emit('scan_update', {'status': 'error', 'message': f'不允许的选项: {option}'})
            return
    
    scan_id = str(uuid.uuid4())
    
    socketio.server.enter_room(request.sid, scan_id)
    
    scan_thread = threading.Thread(
        target=run_nmap_scan,
        args=(scan_id, target, ports, valid_options, scan_all_ports, parallel_tasks)
    )
    scan_thread.daemon = True
    
    active_scans[scan_id] = {
        'thread': scan_thread,
        'start_time': time.time(),
        'target': target,
        'parallel_tasks': parallel_tasks
    }
    
    scan_thread.start()
    
    emit('scan_started', {
        'scan_id': scan_id,
        'parallel_tasks': parallel_tasks
    })

@socketio.on('cancel_scan')
def handle_cancel_scan(data):
    scan_id = data.get('scan_id')
    if scan_id in active_scans:
        active_scans[scan_id]['cancelled'] = True
        emit('scan_update', {
            'scan_id': scan_id,
            'status': 'cancelled',
            'message': '扫描已取消'
        }, room=scan_id)

@app.route('/scan', methods=['POST'])
def scan():
    data = request.get_json()
    
    if not data:
        return jsonify({"error": "没有提供数据"}), 400
    
    target = data.get('target', '')
    ports = data.get('ports', '')
    selected_options = data.get('options', [])
    scan_all_ports = data.get('scan_all_ports', False)
    
    if not target or not is_valid_target(target):
        return jsonify({"error": "无效的目标格式"}), 400
    
    if not is_valid_ports(ports):
        return jsonify({"error": "无效的端口格式"}), 400
    
    for option in selected_options:
        if option not in ALLOWED_OPTIONS:
            return jsonify({"error": f"不允许的选项: {option}"}), 400
    
    command = ["nmap"]
    
    for option in selected_options:
        command.append(option)
    
    if scan_all_ports:
        command.extend(["-p-"])
    elif ports:
        command.extend(["-p", ports])
    
    command.append(target)
    
    try:
        process = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=600
        )
        
        if process.returncode != 0:
            return jsonify({
                "error": "扫描失败",
                "message": process.stderr
            }), 500
        
        return jsonify({
            "result": process.stdout,
            "command": " ".join(command)
        })
        
    except subprocess.TimeoutExpired:
        return jsonify({"error": "扫描超时"}), 408
    except Exception as e:
        return jsonify({"error": f"扫描过程中出错: {str(e)}"}), 500

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True) 