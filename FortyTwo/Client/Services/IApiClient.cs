using FortyTwo.Client.ViewModels;
using FortyTwo.Shared.DTO;
using FortyTwo.Shared.Models;
using System;
using System.Threading.Tasks;

namespace FortyTwo.Client.Services
{
    public interface IApiClient
    {
        Task FetchMatchesAsync(MatchFilter? matchFilter = null);
        Task FetchMatchAsync(Guid matchId);
        Task<LoggedInPlayer> FetchMatchPlayerAsync(Guid matchId);
        Task CreateMatchAsync();
        Task DeleteMatchAsync(Guid matchId);
        Task JoinMatchAsync(Guid matchId, Teams team);
        Task<bool> UpdateMatchPlayerAsync(Guid matchId, bool ready);
        Task<bool> BidAsync(Guid matchId, Bid bid);
        Task<bool> SelectTrumpAsync(Guid matchId, Suit suit);
        Task<bool> MakeMoveAsync(Guid matchId, Domino domino);
    }
}
