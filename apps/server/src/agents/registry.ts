import type { ServerConfig } from '../config'
import type { ServerAgent } from './types'
import { ComputerAgent } from './computer-agent'
import { FilesAgent } from './files-agent'
import { CodingAgent } from './coding-agent'

export function createAgents(config: ServerConfig): ServerAgent[] {
  const agents: ServerAgent[] = [new ComputerAgent(), new FilesAgent()]
  if (config.codingCommand) {
    agents.push(new CodingAgent(config.codingCommand, config.codingArgsTemplate ?? ['{{prompt}}']))
  }
  return agents
}
