# 快速分析会话记录中的工具调用失败
param(
    [string]$SessionPath = "$env:USERPROFILE\.pi\agent\sessions\--E--_workSpace-_Agents-pi--",
    [string]$OutputPath = "E:/_workSpace/_Agents/pi/tool-failures-analysis",
    [int]$MaxFiles = 20  # 只处理最近的20个文件
)

# 创建输出目录
if (!(Test-Path $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
}

# 获取最近的会话文件
$sessionFiles = Get-ChildItem -Path $SessionPath -Filter "*.jsonl" | Sort-Object LastWriteTime -Descending | Select-Object -First $MaxFiles

Write-Host "分析最近的 $($sessionFiles.Count) 个会话文件"

$allFailures = @()
$allSuccesses = @()

foreach ($file in $sessionFiles) {
    Write-Host "处理: $($file.Name)"
    
    $lines = Get-Content -Path $file.FullName -Encoding UTF8
    $messages = @()
    
    # 解析所有行
    foreach ($line in $lines) {
        try {
            $json = $line | ConvertFrom-Json
            if ($json.type -eq "message") {
                $messages += $json
            }
        } catch {
            # 忽略解析错误
        }
    }
    
    # 查找工具调用失败和成功
    for ($i = 0; $i -lt $messages.Count; $i++) {
        $msg = $messages[$i]
        
        # 检查是否是工具结果
        if ($msg.message.role -eq "toolResult") {
            $toolName = $msg.message.toolName
            $toolCallId = $msg.message.toolCallId
            $isError = $msg.message.isError
            $timestamp = $msg.timestamp
            
            # 查找对应的工具调用（在前面的消息中）
            $toolCall = $null
            for ($j = $i - 1; $j -ge 0; $j--) {
                if ($messages[$j].message.role -eq "assistant") {
                    $content = $messages[$j].message.content
                    if ($content -is [array]) {
                        foreach ($item in $content) {
                            if ($item.type -eq "toolCall" -and $item.id -eq $toolCallId) {
                                $toolCall = $item
                                break
                            }
                        }
                    }
                    if ($toolCall) { break }
                }
            }
            
            # 查找前面的用户消息（上下文）
            $userMessage = $null
            for ($j = $i - 1; $j -ge 0; $j--) {
                if ($messages[$j].message.role -eq "user") {
                    $userMessage = $messages[$j]
                    break
                }
            }
            
            # 构建记录
            $record = @{
                SessionFile = $file.Name
                Timestamp = $timestamp
                ToolName = $toolName
                ToolCallId = $toolCallId
                IsError = $isError
                ToolCallArguments = if ($toolCall) { $toolCall.arguments } else { $null }
                ToolResultContent = $msg.message.content
                ErrorMessage = $msg.message.errorMessage
                UserMessage = if ($userMessage) { 
                    ($userMessage.message.content | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text }) -join " "
                } else { $null }
                ContextBefore = @()
                ContextAfter = @()
            }
            
            # 获取前后上下文（最多2条消息）
            $startIdx = [Math]::Max(0, $i - 2)
            $endIdx = [Math]::Min($messages.Count - 1, $i + 2)
            
            for ($k = $startIdx; $k -le $endIdx; $k++) {
                $contextMsg = $messages[$k]
                $contextRecord = @{
                    Index = $k
                    Role = $contextMsg.message.role
                    Timestamp = $contextMsg.timestamp
                    Content = if ($contextMsg.message.content -is [array]) {
                        ($contextMsg.message.content | ForEach-Object {
                            if ($_.type -eq "text") { $_.text }
                            elseif ($_.type -eq "toolCall") { "[Tool Call: $($_.name)]" }
                            elseif ($_.type -eq "thinking") { "[Thinking]" }
                            else { "[$($_.type)]" }
                        }) -join " "
                    } elseif ($contextMsg.message.content) {
                        $contextMsg.message.content
                    } else { "" }
                    IsError = $contextMsg.message.isError
                }
                
                if ($k -lt $i) {
                    $record.ContextBefore += $contextRecord
                } elseif ($k -gt $i) {
                    $record.ContextAfter += $contextRecord
                }
            }
            
            if ($isError -eq $true) {
                $allFailures += $record
            } else {
                $allSuccesses += $record
            }
        }
    }
}

Write-Host "`n找到 $($allFailures.Count) 个工具调用失败"
Write-Host "找到 $($allSuccesses.Count) 个工具调用成功"

# 按工具名称分组失败记录
$failuresByTool = $allFailures | Group-Object -Property ToolName

# 查找相似工具的成功调用
$similarSuccesses = @()
foreach ($failure in $allFailures) {
    $matchingSuccesses = $allSuccesses | Where-Object { 
        $_.ToolName -eq $failure.ToolName -and 
        $_.ToolCallArguments.command -eq $failure.ToolCallArguments.command
    }
    
    if ($matchingSuccesses) {
        $similarSuccesses += @{
            Failure = $failure
            Successes = $matchingSuccesses
        }
    }
}

# 生成详细报告
$report = @"
# 工具调用失败分析报告

生成时间: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
分析会话数: $($sessionFiles.Count) (最近的文件)
总失败数: $($allFailures.Count)
总成功数: $($allSuccesses.Count)

## 失败记录按工具分类

"@

foreach ($group in $failuresByTool) {
    $report += "`n### $($group.Name) ($($group.Count) 次失败)`n`n"
    
    foreach ($failure in $group.Group) {
        $report += @"
**时间**: $($failure.Timestamp)
**会话**: $($failure.SessionFile)
**错误**: $($failure.ErrorMessage)

**用户请求**:
$($failure.UserMessage)

**工具调用参数**:
$($failure.ToolCallArguments | ConvertTo-Json -Depth 3)

**错误内容**:
$($failure.ToolResultContent | ConvertTo-Json -Depth 3)

**上下文（前）**:
$($failure.ContextBefore | ForEach-Object { "[$($_.Role)] $($_.Content)" } | Out-String)

**上下文（后）**:
$($failure.ContextAfter | ForEach-Object { "[$($_.Role)] $($_.Content)" } | Out-String)

---

"@
    }
}

# 添加相似工具成功调用的对比
if ($similarSuccesses.Count -gt 0) {
    $report += "`n## 相似工具成功调用对比`n`n"
    
    foreach ($item in $similarSuccesses) {
        $failure = $item.Failure
        $successes = $item.Successes
        
        $report += @"
### 失败调用
- **工具**: $($failure.ToolName)
- **时间**: $($failure.Timestamp)
- **参数**: $($failure.ToolCallArguments | ConvertTo-Json -Depth 3)
- **错误**: $($failure.ErrorMessage)

### 相似成功调用
"@
        
        foreach ($success in $successes) {
            $report += @"
- **时间**: $($success.Timestamp)
- **会话**: $($success.SessionFile)
- **结果**: $($success.ToolResultContent | ConvertTo-Json -Depth 3)

"@
        }
        
        $report += "`n---`n`n"
    }
}

# 保存报告
$report | Out-File -FilePath "$OutputPath/analysis-report.md" -Encoding UTF8

# 保存原始数据
$allFailures | ConvertTo-Json -Depth 5 | Out-File -FilePath "$OutputPath/failures-raw.json" -Encoding UTF8
$allSuccesses | ConvertTo-Json -Depth 5 | Out-File -FilePath "$OutputPath/successes-raw.json" -Encoding UTF8

# 生成CSV摘要
$csvData = $allFailures | ForEach-Object {
    [PSCustomObject]@{
        Timestamp = $_.Timestamp
        ToolName = $_.ToolName
        ErrorMessage = $_.ErrorMessage
        SessionFile = $_.SessionFile
        UserMessage = if ($_.UserMessage) { $_.UserMessage.Substring(0, [Math]::Min(100, $_.UserMessage.Length)) } else { "" }
    }
}
$csvData | Export-Csv -Path "$OutputPath/failures-summary.csv" -NoTypeInformation -Encoding UTF8

Write-Host "`n分析完成！报告已保存到: $OutputPath"
Write-Host "- analysis-report.md: 详细分析报告"
Write-Host "- failures-raw.json: 失败记录原始数据"
Write-Host "- successes-raw.json: 成功记录原始数据"
Write-Host "- failures-summary.csv: 失败记录摘要"
