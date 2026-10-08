#!/usr/bin/env python3
"""Read native RC and loaded-thread status through an existing control socket."""
import base64
import json
import os
import pathlib
import socket
import struct
import sys
import time

home = pathlib.Path(sys.argv[1])
connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
connection.settimeout(8)
connection.connect(str(home / 'app-server-control/app-server-control.sock'))
key = base64.b64encode(os.urandom(16)).decode()
connection.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                    'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key +
                    '\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
buffer = b''
while b'\r\n\r\n' not in buffer:
    chunk = connection.recv(65536)
    if not chunk:
        raise EOFError('socket closed during upgrade')
    buffer += chunk
header, buffer = buffer.split(b'\r\n\r\n', 1)
if b' 101 ' not in header.split(b'\r\n')[0]:
    raise RuntimeError('websocket upgrade failed')


def exact(count):
    global buffer
    while len(buffer) < count:
        chunk = connection.recv(max(65536, count - len(buffer)))
        if not chunk:
            raise EOFError('socket closed')
        buffer += chunk
    result, buffer = buffer[:count], buffer[count:]
    return result


def send(value, opcode=1):
    data = json.dumps(value).encode() if opcode == 1 else value
    mask = os.urandom(4)
    size = len(data)
    length = bytes([128 + size]) if size < 126 else bytes([254]) + struct.pack('!H', size)
    connection.sendall(bytes([128 + opcode]) + length + mask +
                       bytes(value ^ mask[i % 4] for i, value in enumerate(data)))


def read():
    data = b''
    while True:
        first, second = exact(2)
        size = second & 127
        if size == 126:
            size = struct.unpack('!H', exact(2))[0]
        elif size == 127:
            size = struct.unpack('!Q', exact(8))[0]
        if size > 8 * 1024 * 1024:
            raise RuntimeError('diagnostic frame too large')
        mask = exact(4) if second & 128 else None
        payload = exact(size)
        if mask:
            payload = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
        opcode = first & 15
        if opcode == 9:
            send(payload, 10)
        elif opcode == 8:
            raise EOFError('websocket closed')
        elif opcode in (0, 1):
            data += payload
            if first & 128:
                return json.loads(data)


sequence = 0


def request(method, params=None):
    global sequence
    sequence += 1
    value = {'id': sequence, 'method': method}
    if params is not None:
        value['params'] = params
    send(value)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        value = read()
        if value.get('id') == sequence:
            if 'error' in value:
                raise RuntimeError(str(value['error']))
            return value['result']
    raise TimeoutError(method)


try:
    request('initialize', {'clientInfo': {'name': 'rc_maintenance', 'version': '1.0'},
                           'capabilities': {'experimentalApi': True}})
    send({'method': 'initialized'})
    status = request('remoteControl/status/read')
    loaded = request('thread/loaded/list', {'limit': 100})
    if loaded.get('nextCursor'):
        raise RuntimeError('loaded-thread inventory exceeds diagnostic bound')
    threads = []
    for thread_id in loaded['data']:
        thread = request('thread/read', {'threadId': thread_id, 'includeTurns': False})['thread']
        threads.append({'id': thread_id, 'provider': thread.get('modelProvider'),
                        'status': thread.get('status')})
    listed = request('thread/list', {'limit': 100, 'useStateDbOnly': True})
    result = {'remote': status, 'loaded': threads,
              'defaultList': [{'id': thread['id'], 'provider': thread.get('modelProvider')}
                              for thread in listed['data']]}
    if '--clients' in sys.argv and status.get('environmentId'):
        clients = request('remoteControl/client/list', {'environmentId': status['environmentId'], 'limit': 100})
        result['registeredClientCount'] = len(clients.get('data', []))
    print(json.dumps(result))
finally:
    connection.close()
