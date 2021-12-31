using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;

namespace FortyTwo.Server.Services
{
    public interface IMatchService
    {
        Task<Match> CreateAsync();
        Task<List<Match>> FetchForUserAsync();
        Task<List<Match>> FetchJoinableAsync();
        Task<Match> GetAsync(Guid id);
    }
}
