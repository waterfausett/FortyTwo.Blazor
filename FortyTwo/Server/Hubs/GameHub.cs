using FortyTwo.Shared.Models;
using Microsoft.AspNetCore.SignalR;
using System;
using System.Threading.Tasks;

namespace FortyTwo.Server.Hubs
{
    public class GameHub : Hub
    {
        public async Task JoinGameAsync(Guid matchId)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, matchId.ToString());
        }

        public async Task LeaveGameAsync(string groupName)
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, groupName);
        }

        public async Task BroadcastToGameAsync(Guid matchId, string playerId, string message)
        {
            await Clients.Group(matchId.ToString()).SendAsync("OnGameMessage", playerId, message);
        }

        public async Task BroadcastToTeamAsync(Guid matchId, string playerId, Guid teamId, string message)
        {
            await Clients.Group(matchId.ToString()).SendAsync("OnTeamMessage", playerId, teamId, message);
        }

        public async Task JoinPlayerAsync(Guid matchId, Player player)
        {
            await Clients.Group(matchId.ToString()).SendAsync("OnPlayerAdded", player);
        }
    }
}
