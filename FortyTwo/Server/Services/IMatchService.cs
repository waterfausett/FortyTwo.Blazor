using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using FortyTwo.Entity.Models;
using FortyTwo.Shared.Models;

namespace FortyTwo.Server.Services
{
    public interface IMatchService
    {
        Task<Match> CreateAsync();
        Task DeleteAsync(Guid id);
        Task<List<Match>> FetchForUserAsync(Shared.DTO.MatchFilter filter);
        Task<Match> GetAsync(Guid id);
        Task<Match> PatchPlayerAsync(Guid id, Shared.DTO.PlayerPatchRequest request);
        Task<Match> AddPlayerAsync(Guid id, Teams team);
        Task<Match> BidAsync(Guid id, Bid bid);
        Task<Match> SetTrumpForCurrentGameAsync(Guid id, Suit suit);
        Task<Match> PlayDominoAsync(Guid id, Domino domino);
        Task<Shared.DTO.LoggedInPlayer> GetPlayerForMatch(Guid id);
    }
}
