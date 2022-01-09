using FortyTwo.Client.ViewModels;
using System;
using System.Threading.Tasks;

namespace FortyTwo.Client.Services
{
    public interface IApiClient
    {
        Task FetchMatchesAsync(MatchFilter? matchFilter = null);
        Task CreateMatchAsync();
        Task DeleteMatchAsync(Guid matchId);
        Task JoinMatchAsync(Guid matchId, FortyTwo.Shared.Models.Teams team);
    }
}
